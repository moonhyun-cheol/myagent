import { startApiServer } from './api-server.js';

const port = Number(process.env.CQR_API_PORT ?? 10200);

startApiServer(port);
