#!/usr/bin/env node
import fs from 'node:fs';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
const outfile = 'dist/main.mjs';

const options: esbuild.BuildOptions = {
	entryPoints: ['src/main.ts'],
	bundle: true,
	logLevel: 'info',
	banner: {
		js: `#!/usr/bin/env node
// Bundled with esbuild
// ${pkg.name}@${pkg.version}

var require,__filename,__dirname;
{
  const {createRequire} = await import('node:module');
  require ||= createRequire(import.meta.url);
}
{
  const {fileURLToPath} = await import('node:url');
  const {dirname} = await import('node:path');
  __filename ||= fileURLToPath(import.meta.url);
  __dirname ||= dirname(__filename)
};
`,
	},
	define: {
		NODE_ENV: JSON.stringify('production'),
		__DEV__: JSON.stringify(false),
		'process.env.NODE_ENV': JSON.stringify('production'),
	},
	keepNames: true,
	treeShaking: true,
	minifySyntax: true,
	outfile,
	format: 'esm',
	platform: 'node',
	charset: 'utf8',
	target: 'node18',
	sourcemap: false,
	legalComments: 'none',
	// Bundle everything since we want a single executable
	external: [],
};

// Ensure dist directory exists
fs.mkdirSync('dist', { recursive: true });

console.log('Building MSSQL MCP server...');

const result = await esbuild.build(options);

if (result.errors.length === 0) {
	// Make the output file executable (Unix/macOS only, Windows ignores)
	try {
		fs.chmodSync(outfile, 0o755);
	} catch (error) {
		// Ignore chmod errors on Windows
	}

	const stats = fs.statSync(outfile);
	const sizeBytes = stats.size;
	const sizeKB = (sizeBytes / 1024).toFixed(1);
	const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

	console.log(`✅ Build successful!`);
	console.log(`📦 Output: ${outfile}`);
	console.log(`📏 Bundle size: ${sizeMB} MB (${sizeKB} KB, ${sizeBytes.toLocaleString()} bytes)`);

	// Size warnings
	if (sizeBytes > 10 * 1024 * 1024) {
		console.log(`⚠️  Warning: Bundle size exceeds 10 MB. Consider reviewing dependencies.`);
	} else if (sizeBytes > 5 * 1024 * 1024) {
		console.log(`ℹ️  Info: Bundle size is relatively large (>5 MB). Monitor for growth.`);
	} else {
		console.log(`✨ Bundle size is optimal (<5 MB)`);
	}

	console.log(`🚀 Ready for npm publish and npx usage`);
} else {
	console.error('❌ Build failed:', result.errors);
	process.exit(1);
}
