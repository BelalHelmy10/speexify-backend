// index.js (root)

import app from "./src/app.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is running on http://0.0.0.0:${PORT}`);
});
