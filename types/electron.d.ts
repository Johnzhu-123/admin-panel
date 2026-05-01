declare global {
  type UpdateInfo = {
    version: string;
    releaseName?: string;
    releaseNotes?: string;
  };

  interface Window {
    electronAPI?: {
      checkForUpdates: () => Promise<{ ok: boolean; message?: string }>;
      downloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
      installUpdate: () => Promise<{ ok: boolean; message?: string }>;
      onUpdateAvailable: (handler: (info: UpdateInfo) => void) => () => void;
      onUpdateNotAvailable: (handler: () => void) => () => void;
      onUpdateProgress: (handler: (progress: { percent?: number }) => void) => () => void;
      onUpdateDownloaded: (handler: (info: UpdateInfo) => void) => () => void;
      onUpdateError: (handler: (error: { message?: string }) => void) => () => void;
      writeLog: (level: "log" | "warn" | "error", message: string) => void;
      getLogPath: () => Promise<{ ok: boolean; path?: string; dir?: string }>;
      openLogDirectory: () => Promise<{ ok: boolean; message?: string; dir?: string }>;
    };
  }
}

export {};
