export interface ConfigurationFileHealth {
  permissions: boolean;
  services: boolean;
  userConfigsDir: boolean;
  backupsDir: boolean;
}

export interface SystemHealthStatus {
  isHealthy: boolean;
  services: Record<string, boolean>;
  permissions: boolean;
  storage: boolean;
  lastChecked: Date;
}

export interface BuildSystemHealthStatusInput {
  services: Record<string, boolean>;
  permissions: boolean;
  storageFiles?: ConfigurationFileHealth | null;
  databaseAvailable?: boolean;
  lastChecked?: Date;
}

const areLocalConfigFilesHealthy = (storageFiles?: ConfigurationFileHealth | null): boolean => {
  if (!storageFiles) return false;
  return Object.values(storageFiles).every(Boolean);
};

const areServicesHealthy = (services: Record<string, boolean>): boolean => {
  const results = Object.values(services);
  if (results.length === 0) return true;
  return results.some(Boolean);
};

export function buildSystemHealthStatus(
  input: BuildSystemHealthStatusInput
): SystemHealthStatus {
  const storage =
    Boolean(input.databaseAvailable) || areLocalConfigFilesHealthy(input.storageFiles);
  const serviceLayer = areServicesHealthy(input.services);

  return {
    isHealthy: serviceLayer && input.permissions && storage,
    services: input.services,
    permissions: input.permissions,
    storage,
    lastChecked: input.lastChecked || new Date(),
  };
}
