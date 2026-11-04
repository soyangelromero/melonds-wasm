// Appended to dist/phase1.js (--extern-post-js). Runs main() only when the file is
// executed directly (`node dist/phase1.js`); importing it as a module stays side-effect free.
import { pathToFileURL as __pathToFileURL } from "node:url";
if (typeof process !== "undefined" && process.argv[1] &&
    import.meta.url === __pathToFileURL(process.argv[1]).href) {
  await Module();
}
