import {
  inferMimeTypeFromBase64Payload,
  normalizeBase64Payload,
  normalizeImageResponseValueToUrl,
} from "../response-url";

describe("image response url normalization", () => {
  it("keeps full data urls unchanged", () => {
    const input = "data:image/webp;base64,UklGRlIAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSA==";
    expect(normalizeImageResponseValueToUrl(input)).toBe(input);
  });

  it("infers jpeg mime type from raw base64", () => {
    const input = "/9j/4AAQSkZJRgABAQAAAQABAAD";
    expect(normalizeImageResponseValueToUrl(input)).toBe(`data:image/jpeg;base64,${input}`);
  });

  it("infers webp mime type from raw base64", () => {
    const input = "UklGRkoAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSA";
    expect(normalizeImageResponseValueToUrl(input)).toBe(`data:image/webp;base64,${input}`);
  });

  it("extracts markdown wrapped data urls", () => {
    const input = "![Generated Image](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD)";
    expect(normalizeImageResponseValueToUrl(input)).toBe(
      "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD"
    );
  });

  it("normalizes url-safe base64 payloads instead of deleting characters", () => {
    const input = "YWJjZA-_";
    expect(normalizeBase64Payload(input)).toBe("YWJjZA+/");
  });

  it("keeps url-safe base64 image payloads renderable", () => {
    const input = "UklGRkoAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSA-_";
    expect(normalizeImageResponseValueToUrl(input)).toBe(
      "data:image/webp;base64,UklGRkoAAABXRUJQVlA4WAoAAAAQAAAADwAADwAAQUxQSA+/"
    );
  });

  it("defaults unknown payloads to png", () => {
    expect(inferMimeTypeFromBase64Payload("abcdefg")).toBe("image/png");
  });
});
