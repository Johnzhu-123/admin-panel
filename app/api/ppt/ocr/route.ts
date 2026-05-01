import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

export const runtime = "nodejs";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const OCR_SETUP_GUIDE = [
  "请先完成本地 OCR 环境配置后再重试：",
  "1) 确保存在 python/ocrpdf_to_ppt/cli.py；",
  "2) 安装 OCR 依赖（推荐在系统 Python 中）：",
  "   python -m pip install -U rapidocr_onnxruntime paddlepaddle paddleocr python-pptx pillow numpy opencv-python pymupdf requests",
  "3) 若你使用自定义 Python，请设置环境变量 OCR_PPTX_PYTHON 指向对应 python.exe。",
].join("\\n");

type OcrSetupError = Error & {
  code?: string;
  requiresSetup?: boolean;
  setupHint?: string;
};

type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type OcrRequestPayload = {
  images?: string[];
  iopaint?: {
    enabled?: boolean;
    url?: string;
    urls?: string[];
  };
};

const normalizeUrl = (value?: string) => (value || "").trim().replace(/\/+$/, "");
const parseUrls = (raw: unknown) => {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((item) => normalizeUrl(String(item || "")))
          .filter((item) => /^https?:\/\//i.test(item))
      )
    );
  }
  if (typeof raw === "string") {
    return Array.from(
      new Set(
        raw
          .split(/[\n,;]/)
          .map((item) => normalizeUrl(item))
          .filter((item) => /^https?:\/\//i.test(item))
      )
    );
  }
  return [] as string[];
};
const rotateUrls = (urls: string[]) => {
  if (urls.length <= 1) return urls;
  const offset = Date.now() % urls.length;
  return [...urls.slice(offset), ...urls.slice(0, offset)];
};

type PythonCandidate = {
  command: string;
  argsPrefix: string[];
  label: string;
  embeddedDir?: string;
};

const createSetupError = (message: string, setupHint: string): OcrSetupError => {
  const error = new Error(message) as OcrSetupError;
  error.code = "OCR_SETUP_REQUIRED";
  error.requiresSetup = true;
  error.setupHint = setupHint;
  return error;
};

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

const summarizeLog = (value: string, maxLen = 900, fromEnd = false) => {
  const text = stripAnsi((value || "").replace(/\u0000/g, "").trim());
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return fromEnd ? text.slice(-maxLen) : text.slice(0, maxLen);
};

const extractIopaintFailureDetail = (value: string, maxLen = 500) => {
  const text = stripAnsi((value || "").replace(/\u0000/g, ""));
  if (!text) return "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markedLine = lines.find((line) => /iopaint_required_failed/i.test(line));
  const raw = markedLine
    ? markedLine.replace(/^.*iopaint_required_failed[:\s-]*/i, "")
    : (text.match(/iopaint_required_failed[:\s-]*([^\r\n]+)/i)?.[1] || "");
  return raw.replace(/\s+/g, " ").trim().slice(0, maxLen);
};

const runProcess = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10 * 60 * 1000
) =>
  new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\\nProcess timeout after ${timeoutMs}ms.`,
      });
    }, timeoutMs);

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stderr += error.message;
      resolve({ code: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

const classifyOcrError = (error: any, fallbackMessage: string) => {
  const rawMessage = (error?.message || fallbackMessage || "OCR conversion failed.").toString();
  const lower = rawMessage.toLowerCase();
  const requiresSetup =
    error?.requiresSetup === true ||
    error?.code === "OCR_SETUP_REQUIRED" ||
    lower.includes("ocr_setup_required") ||
    lower.includes("ocr script not found") ||
    lower.includes("python was not found") ||
    lower.includes("is not recognized as an internal or external command") ||
    lower.includes("no module named") ||
    lower.includes("missing python packages");

  if (!requiresSetup) {
    return {
      status: 500,
      body: {
        error: rawMessage,
      },
    };
  }

  return {
    status: 424,
    body: {
      error: "可编辑 PPTX 功能尚未完成本地 OCR 配置。",
      code: "OCR_SETUP_REQUIRED",
      requiresSetup: true,
      setupHint: error?.setupHint || OCR_SETUP_GUIDE,
      detail: rawMessage.slice(0, 2000),
    },
  };
};

const saveDataUrlImages = async (images: string[], dir: string) => {
  await fs.mkdir(dir, { recursive: true });

  for (let i = 0; i < images.length; i++) {
    const dataUrl = images[i] || "";
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      throw new Error(`Image ${i + 1} must be a base64 data URL.`);
    }

    const mime = match[1];
    const base64 = match[2];
    const ext = mime.split("/")[1] || "png";
    const filename = `slide-${String(i + 1).padStart(3, "0")}.${ext}`;
    const filePath = path.join(dir, filename);
    const buffer = Buffer.from(base64, "base64");
    await fs.writeFile(filePath, buffer);
  }
  return images.length;
};

const mimeToExt = (mime: string) => {
  const lowered = (mime || "").toLowerCase();
  if (lowered.includes("jpeg") || lowered.includes("jpg")) return "jpg";
  if (lowered.includes("webp")) return "webp";
  if (lowered.includes("bmp")) return "bmp";
  if (lowered.includes("gif")) return "gif";
  return "png";
};

const saveFormDataImages = async (formData: FormData, dir: string) => {
  await fs.mkdir(dir, { recursive: true });
  const values = formData.getAll("images");
  let count = 0;

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === "string") {
      const dataUrl = value.trim();
      if (!dataUrl.startsWith("data:image/")) continue;
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) continue;
      const ext = mimeToExt(match[1]);
      const filePath = path.join(dir, `slide-${String(count + 1).padStart(3, "0")}.${ext}`);
      await fs.writeFile(filePath, Buffer.from(match[2], "base64"));
      count++;
      continue;
    }

    const file = value as File;
    if (!file || typeof file.arrayBuffer !== "function") continue;
    const arrayBuffer = await file.arrayBuffer();
    if (!arrayBuffer.byteLength) continue;
    const ext = mimeToExt(file.type || file.name);
    const filePath = path.join(dir, `slide-${String(count + 1).padStart(3, "0")}.${ext}`);
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
    count++;
  }
  return count;
};

const findScriptPath = () => {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(process.cwd(), "python", "ocrpdf_to_ppt", "cli.py"),
    resourcesPath
      ? path.join(resourcesPath, "app.asar.unpacked", "python", "ocrpdf_to_ppt", "cli.py")
      : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
};

const buildPythonCandidates = () => {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  const pythonOverride = (process.env.OCR_PPTX_PYTHON || "").trim();
  const runtimeCandidates = [
    path.join(process.cwd(), "python", "ocr_runtime", "Scripts", "python.exe"),
    resourcesPath
      ? path.join(
          resourcesPath,
          "app.asar.unpacked",
          "python",
          "ocr_runtime",
          "Scripts",
          "python.exe"
        )
      : "",
  ].filter(Boolean);
  const embeddedDirCandidates = [
    path.join(process.cwd(), "python", "embedded"),
    resourcesPath ? path.join(resourcesPath, "app.asar.unpacked", "python", "embedded") : "",
  ].filter(Boolean);
  const embeddedPythonCandidates = embeddedDirCandidates
    .filter((dir) => existsSync(path.join(dir, "python.exe")))
    .map<PythonCandidate>((dir) => ({
      command: path.join(dir, "python.exe"),
      argsPrefix: [],
      label: `embedded (${dir})`,
      embeddedDir: dir,
    }));

  const candidates: PythonCandidate[] = [];
  if (pythonOverride) {
    candidates.push({
      command: pythonOverride,
      argsPrefix: [],
      label: `OCR_PPTX_PYTHON (${pythonOverride})`,
    });
  }
  for (const runtimePython of runtimeCandidates) {
    if (existsSync(runtimePython)) {
      candidates.push({
        command: runtimePython,
        argsPrefix: [],
        label: `bundled runtime (${runtimePython})`,
      });
    }
  }
  candidates.push(...embeddedPythonCandidates);
  candidates.push({
    command: "python",
    argsPrefix: [],
    label: "system python",
  });

  const seen = new Set<string>();
  return candidates.filter((item) => {
    const key = `${item.command}|${item.argsPrefix.join(" ")}|${item.embeddedDir || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const buildRuntimeEnv = (modelCache: string, embeddedDir?: string) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PADDLE_PDX_CACHE_HOME: modelCache,
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    OCR_PPTX_BACKEND: process.env.OCR_PPTX_BACKEND || "rapid",
  };

  if (embeddedDir) {
    const sitePackages = path.join(embeddedDir, "Lib", "site-packages");
    env.PYTHONHOME = embeddedDir;
    env.PYTHONPATH = env.PYTHONPATH
      ? `${sitePackages}${path.delimiter}${env.PYTHONPATH}`
      : sitePackages;
  }

  return env;
};

const resolvePythonRunner = async (scriptPath: string, modelCache: string) => {
  const candidates = buildPythonCandidates();
  const failures: string[] = [];

  for (const candidate of candidates) {
    const env = buildRuntimeEnv(modelCache, candidate.embeddedDir);
    const args = [...candidate.argsPrefix, scriptPath, "--self-check"];
    const result = await runProcess(candidate.command, args, process.cwd(), env, 2 * 60 * 1000);
    if (result.code === 0) {
      return { candidate, env };
    }
    const detail = summarizeLog(result.stderr || result.stdout) || "self-check failed";
    failures.push(`${candidate.label}: ${detail}`);
  }

  throw createSetupError(
    "No usable Python runtime found for OCR conversion.",
    `${OCR_SETUP_GUIDE}\\n\\n自检失败详情：\\n- ${failures.join("\\n- ")}`.slice(0, 4000)
  );
};

export async function POST(request: Request) {
  if (process.env.ELECTRON_DESKTOP !== "1") {
    return NextResponse.json(
      { error: "OCR PPTX conversion is only available in the desktop app." },
      { status: 403 }
    );
  }

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const fallbackRequest = request.clone();

  const scriptPath = findScriptPath();
  if (!scriptPath) {
    const normalized = classifyOcrError(
      createSetupError(
        "OCR script not found. Ensure python/ocrpdf_to_ppt/cli.py exists.",
        OCR_SETUP_GUIDE
      ),
      "OCR conversion failed."
    );
    return NextResponse.json(normalized.body, { status: normalized.status });
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ocrpptx-"));
  const inputDir = path.join(tempRoot, "images");
  const outputPath = path.join(tempRoot, "output.pptx");

  try {
    let payload: OcrRequestPayload = {};
    let imageCount = 0;
    if (contentType.includes("multipart/form-data")) {
      try {
        const formData = await request.formData();
        imageCount = await saveFormDataImages(formData, inputDir);
      } catch (formError: any) {
        // Fallback: if multipart parsing fails, try JSON body parsing from a cloned request.
        try {
          const raw = await fallbackRequest.text();
          payload = raw ? JSON.parse(raw) : {};
          const images = Array.isArray(payload?.images) ? payload.images.filter(Boolean) : [];
          imageCount = await saveDataUrlImages(images, inputDir);
        } catch (jsonError) {
          return NextResponse.json(
            { error: `Failed to parse upload body. ${formError?.message || "FormData parse failed."}` },
            { status: 400 }
          );
        }
      }
    } else {
      const raw = await request.text();
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
      }
      const images = Array.isArray(payload.images) ? payload.images.filter(Boolean) : [];
      imageCount = await saveDataUrlImages(images, inputDir);
    }
    if (!imageCount) {
      return NextResponse.json({ error: "No images provided." }, { status: 400 });
    }

    let modelCache =
      process.env.OCR_PPTX_MODEL_DIR || path.join(os.homedir(), ".md2ppt", "paddle_models");
    try {
      await fs.mkdir(modelCache, { recursive: true });
    } catch {
      // Fallback to temp dir if home directory is not writable (sandbox or restricted profile).
      modelCache = path.join(tempRoot, "model_cache");
      await fs.mkdir(modelCache, { recursive: true });
    }

    const { candidate, env } = await resolvePythonRunner(scriptPath, modelCache);
    const args = [...candidate.argsPrefix, scriptPath, "--input-dir", inputDir, "--output", outputPath];

    if (process.env.OCR_PPTX_USE_GPU === "1") {
      args.push("--gpu");
    }
    if (process.env.OCR_PPTX_TEXT_BG) {
      args.push("--text-bg", process.env.OCR_PPTX_TEXT_BG);
    }
    if (process.env.OCR_PPTX_TEXT_BG_ALPHA) {
      args.push("--text-bg-alpha", process.env.OCR_PPTX_TEXT_BG_ALPHA);
    }
    const iopaintEnabled =
      typeof payload?.iopaint?.enabled === "boolean" ? payload.iopaint.enabled : undefined;
    const iopaintUrl =
      typeof payload?.iopaint?.url === "string" ? normalizeUrl(payload.iopaint.url) : "";
    const iopaintUrls = parseUrls(payload?.iopaint?.urls);

    const iopaintStrict = process.env.OCR_PPTX_IOPAINT_STRICT === "1";
    if (iopaintEnabled === false) {
      args.push("--text-removal-mode", "opencv");
    } else {
      // Default to auto: prefer IOPaint, fallback to OpenCV when local IOPaint is unavailable.
      args.push("--text-removal-mode", iopaintStrict ? "iopaint" : "auto");
      const candidateUrls = iopaintUrls.length ? iopaintUrls : iopaintUrl ? [iopaintUrl] : [];
      if (candidateUrls.length) {
        args.push("--iopaint-url", rotateUrls(candidateUrls).join(","));
      }
    }

    const result = await runProcess(candidate.command, args, process.cwd(), env);
    if (result.code !== 0) {
      const rawDetail = result.stderr || result.stdout;
      const detail = summarizeLog(rawDetail, 4000, true);
      const normalizedDetail = (detail || "").toLowerCase();
      if (normalizedDetail.includes("ocr_setup_required")) {
        throw createSetupError(detail || "OCR runtime setup is incomplete.", OCR_SETUP_GUIDE);
      }
      if (normalizedDetail.includes("iopaint_required_failed")) {
        const compactDetail = extractIopaintFailureDetail(rawDetail);
        throw new Error(
          `IOPaint 去字失败，请检查 IOPaint 地址、模型加载状态与网络后重试。若未准备 IOPaint，可先在设置中关闭 IOPaint 改用 OpenCV。${
            compactDetail ? `\n详情：${compactDetail}` : ""
          }`
        );
      }
      throw new Error(detail || "OCR conversion failed.");
    }

    if (!existsSync(outputPath)) {
      throw new Error("OCR conversion finished but output PPTX was not generated.");
    }

    const pptxBuffer = await fs.readFile(outputPath);
    return new NextResponse(pptxBuffer, {
      status: 200,
      headers: {
        "Content-Type": PPTX_MIME,
        "Content-Disposition": "attachment; filename=Editable_Presentation.pptx",
        "Cache-Control": "no-store",
      },
    });
  } catch (error: any) {
    const normalized = classifyOcrError(error, "OCR conversion failed.");
    return NextResponse.json(normalized.body, { status: normalized.status });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

