// Run the API over a SQLite database.
//
//   node packages/api/src/main.ts [--port 8095] [--db volatility.db]

import { parseArgs } from "node:util";
import { openSqliteStore } from "@volatility/store-sqlite";
import { startApi } from "./api.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8095" },
    db: { type: "string", default: "volatility.db" },
  },
});

startApi(Number(args.port), openSqliteStore(args.db)).on("listening", () => {
  console.log(`volatility api 127.0.0.1:${args.port} | db ${args.db}`);
});
