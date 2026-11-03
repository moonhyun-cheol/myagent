import { startApiServer } from './api-server.js';
import { getBootstrapPaths, resolveCqrRoot } from './bootstrap.js';
import { readApiPortDefault } from './config/product-version.js';
import { installProcessHealthLog } from './runtime/process-health-log.js';

const cqrRoot = resolveCqrRoot();
const configuredPort = Number(process.env.CQR_API_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
  ? configuredPort
  : readApiPortDefault(cqrRoot);

// Install before boot so a failure inside createApiServer/listen is recorded too.
installProcessHealthLog(getBootstrapPaths(cqrRoot).logsDir, port);
startApiServer(port);
