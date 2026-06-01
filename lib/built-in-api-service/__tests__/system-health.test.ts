import { buildSystemHealthStatus } from "../system-health";

describe("buildSystemHealthStatus", () => {
  it("treats database-backed cloud storage as healthy even without local config files", () => {
    const health = buildSystemHealthStatus({
      services: {},
      permissions: true,
      storageFiles: {
        permissions: false,
        services: false,
        userConfigsDir: false,
        backupsDir: false,
      },
      databaseAvailable: true,
      lastChecked: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(health.storage).toBe(true);
    expect(health.permissions).toBe(true);
    expect(health.isHealthy).toBe(true);
  });

  it("marks storage unhealthy only when neither database nor local config storage is available", () => {
    const health = buildSystemHealthStatus({
      services: {},
      permissions: true,
      storageFiles: {
        permissions: false,
        services: false,
        userConfigsDir: false,
        backupsDir: false,
      },
      databaseAvailable: false,
    });

    expect(health.storage).toBe(false);
    expect(health.isHealthy).toBe(false);
  });
});
