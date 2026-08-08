<script lang="ts">
    import { onMount } from "svelte";
    import { VERSION, parseGgb, renderGgb } from "geoview";

    let canvas: HTMLCanvasElement;
    let fileInput: HTMLInputElement;
    let status = "ready";
    let fileName = "";

    function handleFile(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        fileName = file.name;
        status = `loading ${file.name}...`;

        file.arrayBuffer().then((buf) => {
            try {
                const doc = parseGgb(buf);
                status = `parsed: ${doc.construction.items.length} items, app=${doc.meta.app}`;

                const w = canvas.clientWidth || 800;
                const h = canvas.clientHeight || 600;
                renderGgb(doc, canvas, { width: w, height: h });
                status = `rendered ${fileName} — ${doc.construction.items.length} items`;
            } catch (err) {
                status = `error: ${(err as Error).message}`;
                console.error(err);
            }
        });
    }

    onMount(() => {
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#333";
        ctx.font = "14px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(
            "geoview playground — load a .ggb file to begin",
            canvas.width / 2,
            canvas.height / 2
        );
    });
</script>

<div class="controls">
    <label class="file-btn">
        load .ggb file
        <input
            type="file"
            bind:this={fileInput}
            accept=".ggb"
            on:change={handleFile}
        />
    </label>
    <span class="status">{status}</span>
    <span class="version">v{VERSION}</span>
</div>

<div class="chart-container">
    <canvas bind:this={canvas} width="800" height="600"></canvas>
</div>

<style>
    .controls {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
        align-items: center;
    }
    .controls label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
    }
    .controls input[type="file"] {
        display: none;
    }
    .file-btn {
        padding: 6px 16px;
        border: 1px solid #444;
        border-radius: 4px;
        background: #2a2a4e;
        color: #e0e0e0;
        font-size: 13px;
        cursor: pointer;
    }
    .file-btn:hover {
        background: #3a3a5e;
    }
    .status {
        font-family: monospace;
        font-size: 12px;
        color: #50fa7b;
        min-width: 40px;
    }
    .version {
        font-family: monospace;
        font-size: 12px;
        color: #888;
        margin-left: auto;
    }
    .chart-container {
        background: #ffffff;
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        display: inline-block;
    }
</style>
