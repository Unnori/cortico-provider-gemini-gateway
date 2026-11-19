import { DesktopOAuth, readOAuthConfig } from './oauth.ts';

try {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node src/login.ts <deployment/providers/endpoint>');
  const config = readOAuthConfig(dir);
  if (!config) throw new Error('Copy resources/desktop-oauth.example.json to the endpoint directory as desktop-oauth.json and configure it');
  await new DesktopOAuth(config, dir).login(url => {
    console.log('Open this authorization URL in your browser:');
    console.log(url);
  });
  console.log('OAuth login complete.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
