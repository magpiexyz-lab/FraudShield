import { test as setup } from "@playwright/test";
import { login } from "./helpers";
import { writeFileSync } from "fs";
import path from "path";

const AUTH_FILE = path.join(__dirname, ".auth.json");

setup("authenticate production test user", async ({ page }) => {
  const email = process.env.PROD_TEST_EMAIL;
  const password = process.env.PROD_TEST_PASSWORD;
  if (!email || !password) {
    setup.skip();
    return;
  }

  await login(page, email, password);

  // Save credentials for downstream tests (same format as global-setup.ts)
  const cookies = await page.context().cookies();
  writeFileSync(
    AUTH_FILE,
    JSON.stringify({ email, password, userId: "prod-test-user", cookies })
  );
});
