const esbuild = require('esbuild');
const fs = require('fs/promises');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const root = __dirname;
const outdir = path.join(root, 'dist');
const sqlWasmSource = path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const sqlWasmTarget = path.join(outdir, 'sql-wasm.wasm');

async function copySqlWasm() {
    await fs.mkdir(outdir, { recursive: true });
    await fs.copyFile(sqlWasmSource, sqlWasmTarget);
}

const copySqlWasmPlugin = {
    name: 'copy-sql-wasm',
    setup(build) {
        build.onEnd(async (result) => {
            if (result.errors.length > 0) {
                return;
            }

            try {
                await copySqlWasm();
                console.log('[bundle] copied sql-wasm.wasm to dist');
            } catch (error) {
                console.error('[bundle] failed to copy sql-wasm.wasm', error);
                process.exitCode = 1;
            }
        });
    }
};

const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    outfile: 'dist/extension.js',
    logLevel: 'info',
    plugins: [copySqlWasmPlugin]
};

async function run() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('[bundle] watch mode started');
        return;
    }

    await esbuild.build(buildOptions);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
