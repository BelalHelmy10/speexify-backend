// index.js (root)

import app from "./src/app.js";
import { PORT } from "./src/config/env.js";
import { logger } from "./src/lib/logger.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "Server started");
});
