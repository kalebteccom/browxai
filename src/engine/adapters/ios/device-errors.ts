// The refusal the ios-app engine's physical-device target raises (RFC 0014). The
// message starts with a stable code (`ios-device-locked`, `ios-device-wda-mismatch`,
// ...), so a caller matches on the code and a person reads the rest.

export class IosDeviceError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "IosDeviceError";
    this.code = code;
  }
}
