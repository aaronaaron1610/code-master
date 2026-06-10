const esbuild = require('esbuild');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables from the extension's .env file
const result = dotenv.config({ path: path.join(__dirname, '.env') });
const apiKey = (result.parsed && result.parsed.OPENROUTER_API_KEY) || process.env.OPENROUTER_API_KEY || '';
console.log(`Loaded OpenRouter API Key from .env: ${apiKey ? 'Found (' + apiKey.substring(0, 10) + '...)' : 'Not Found'}`);

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  minify: !isWatch,
  define: {
    'process.env.OPENROUTER_API_KEY': JSON.stringify(apiKey)
  }
};

async function main() {
  // Clean up old tsc files if they exist to prevent confusion
  try {
    const distServices = path.join(__dirname, 'dist', 'services');
    if (fs.existsSync(distServices)) {
      fs.rmSync(distServices, { recursive: true, force: true });
    }
    const mapFile = path.join(__dirname, 'dist', 'extension.js.map');
    if (fs.existsSync(mapFile)) {
      fs.unlinkSync(mapFile);
    }
  } catch (e) {
    console.error('Error cleaning old build files:', e);
  }

  if (isWatch) {
    console.log('Starting esbuild in watch mode...');
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    console.log('Building extension...');
    await esbuild.build(buildOptions);
    console.log('Build completed successfully!');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
