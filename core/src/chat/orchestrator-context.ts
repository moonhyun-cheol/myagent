import type { AttachmentService } from '../attachments/attachment-service.js';
import type { ModelRegistry } from '../models/model-registry.js';
import type { ProviderStore } from '../providers/provider-store.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { ProjectStore } from '../projects/project-store.js';
import type { DeepResearchPipeline } from '../research/deep-research.js';
import type { CloudChatService } from '../providers/cloud-chat.js';
import type { LocalChatService } from '../inference/local-chat.js';
import type { AutoImageBackend } from '../image/image-backend.js';

/** Shared services passed to extracted chat mode handlers. */
export interface OrchestratorContext {
  cqrRoot: string;
  configPath: string;
  dataDir: string;
  vaultDir: string;
  imageOut: string;
  attachments: AttachmentService;
  modelRegistry: ModelRegistry;
  providerStore: ProviderStore;
  sessionStore: SessionStore;
  projectStore: ProjectStore;
  research: DeepResearchPipeline;
  cloudChat: CloudChatService;
  localChat: LocalChatService;
  imageBackend: AutoImageBackend;
}
