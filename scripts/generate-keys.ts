import { randomBytes } from "node:crypto";

/**
 * Prints fresh values for the two application secrets.
 * Run: npm run keys:generate
 */
console.log(`TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`SESSION_SECRET=${randomBytes(32).toString("base64")}`);
console.log(`ADMIN_PASSWORD=${randomBytes(12).toString("base64url")}`);
