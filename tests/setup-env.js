// Imported first by every test file: configuration is read when src/config.js loads,
// so the test environment must be in place before any source module is evaluated.
import { fileURLToPath } from "node:url";

process.env.NODE_MANIFEST_PATH = fileURLToPath(new URL("./fixtures/node.test.json", import.meta.url));
process.env.NODE_OPERATOR_KEY = "test-operator-key";
process.env.NODE_DATA_DIR = fileURLToPath(new URL("../data-test", import.meta.url));
process.env.NODE_ENV = "test";
delete process.env.NODE_SIGNING_PRIVATE_KEY;
