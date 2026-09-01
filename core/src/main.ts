import { startApiServer } from './api-server.js';
import { resolveCqrRoot } from './bootstrap.js';
import { readApiPortDefault } from './config/product-version.js';

const configuredPort = Number(process.env.CQR_API_PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
  ? configuredPort
  : readApiPortDefault(resolveCqrRoot());

startApiServer(port);
