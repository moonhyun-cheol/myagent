import path from 'node:path';
import type { BootstrapPaths } from '../bootstrap.js';
import type { FileLicenseGate } from '../license/file-license-gate.js';
import type { AttachmentService } from '../attachments/attachment-service.js';
import type { ModelRegistry } from '../models/model-registry.js';
import type { ModelUploadService } from '../models/model-upload.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { ProjectStore } from '../projects/project-store.js';
import type { UserSkillStore } from '../skills/user-skill-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { SetupService } from '../setup/setup-service.js';
import type { ChatOrchestrator } from '../chat/chat-orchestrator.js';
import type { UserOverrides } from '../config/user-overrides.js';
import type { PersonalSchedulerService } from '../scheduler/personal-scheduler-service.js';
import type { PersonalSchedulerRuntime } from '../scheduler/personal-scheduler-runtime.js';

export interface ApiContext {
  cqrRoot: string;
  paths: BootstrapPaths;
  port: number;
  appVersion: string;
  /** Primary product UI build (`ui/workspace/dist`). */
  workspaceUiDir: string;
  /** Work Kit Launcher SPA (`bin/work-kit-launcher/web` or `ui/work-kit-launcher/dist`). */
  workKitLauncherUiDir: string | null;
  userConfigPath: string;
  license: FileLicenseGate;
  getOverrides: () => UserOverrides;
  attachments: AttachmentService;
  modelRegistry: ModelRegistry;
  modelUpload: ModelUploadService;
  providerStore: ProviderStore;
  projectStore: ProjectStore;
  userSkillStore: UserSkillStore;
  sessionStore: SessionStore;
  setup: SetupService;
  llamaBinary: ReturnType<typeof import('../inference/llama-backend.js').findLlamaServerBinary>;
  imageOut: string;
  orchestrator: ChatOrchestrator;
  personalScheduler: PersonalSchedulerService;
  personalSchedulerRuntime: PersonalSchedulerRuntime;
}
