<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import { VERSION, parseGgb, renderGgb, createInteractive } from "geoview";
    import type { Renderer, Interactive, HitTarget, ButtonInfo } from "geoview";
    import { createMathJaxLabelRenderer } from "./mathjax-labels";

    let canvas: HTMLCanvasElement;
    let fileInput: HTMLInputElement;
    let status = "ready";
    let fileName = "";
    let renderer: Renderer | null = null;
    let interactive: Interactive | null = null;
    let buttons: ButtonInfo[] = [];

    // MathJax label renderer — converts labels to LaTeX → SVG → Image
    const labelRenderer = createMathJaxLabelRenderer();

    function refreshButtons(): void {
        if (!interactive) {
            buttons = [];
            return;
        }
        buttons = interactive.getButtons();
    }

    function handleFile(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        // Tear down the previous interactive session (cancel any rAF loop).
        interactive?.dispose();

        fileName = file.name;
        status = `loading ${file.name}...`;

        file.arrayBuffer().then((buf) => {
            try {
                const doc = parseGgb(buf);
                const w = canvas.clientWidth || 800;
                const h = canvas.clientHeight || 600;
                renderer = renderGgb(doc, canvas, {
                    width: w,
                    height: h,
                    labelRenderer
                });
                // Enable slider/point dragging (opt-in interactivity).
                interactive = createInteractive(doc, renderer as any, canvas, {
                    width: w,
                    height: h
                });
                interactive.onUpdate(refreshButtons);
                refreshButtons();
                status = `rendered ${fileName} — ${doc.construction.items.length} items`;
            } catch (err) {
                status = `error: ${(err as Error).message}`;
                console.error(err);
            }
        });
    }

    function onButtonClick(label: string): void {
        interactive?.clickButton(label);
        refreshButtons();
    }

    // Pan vs object drag: on pointer-down we hit-test free objects first.
    let panning = false;
    let dragTarget: HitTarget | null = null;
    let lastX = 0;
    let lastY = 0;

    function onMouseDown(e: MouseEvent) {
        if (!renderer || renderer.mode !== "2d") return;
        const target = interactive?.hitTest(e.clientX, e.clientY) ?? null;
        if (target) {
            dragTarget = target;
            interactive?.beginDrag(target);
            canvas.style.cursor = "grabbing";
            return;
        }
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.style.cursor = "grabbing";
    }

    function onMouseMove(e: MouseEvent) {
        if (!renderer || renderer.mode !== "2d") return;
        if (dragTarget) {
            interactive?.dragTo(e.clientX, e.clientY);
            return;
        }
        if (!panning) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        renderer.pan(dx, dy);
    }

    function onMouseUp() {
        panning = false;
        dragTarget = null;
        interactive?.endDrag();
        canvas.style.cursor = "default";
    }

    // Zoom: mouse wheel
    function onWheel(e: WheelEvent) {
        if (!renderer || renderer.mode !== "2d") return;
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        // Wheel up (deltaY < 0) = zoom in, wheel down = zoom out
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        renderer.zoom(factor, cx, cy);
    }

    // Reset view: double click
    function onDblClick() {
        if (!renderer || renderer.mode !== "2d") return;
        renderer.resetView();
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

    onDestroy(() => {
        interactive?.dispose();
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
    <canvas
        bind:this={canvas}
        width="800"
        height="600"
        on:mousedown={onMouseDown}
        on:mousemove={onMouseMove}
        on:mouseup={onMouseUp}
        on:mouseleave={onMouseUp}
        on:wheel|nonpassive={onWheel}
        on:dblclick={onDblClick}
    ></canvas>
    <div class="button-layer">
        {#each buttons as btn (btn.label)}
            <button
                class="ggb-button"
                style="left:{btn.x}px; top:{btn.y}px;"
                on:click={() => onButtonClick(btn.label)}
            >{btn.caption}</button>
        {/each}
    </div>
</div>

<div class="hint">
    drag points/sliders to interact · drag empty space to pan · scroll to zoom · double-click to reset
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
        position: relative;
    }
    .button-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
    }
    .ggb-button {
        position: absolute;
        pointer-events: auto;
        padding: 6px 14px;
        border: 1px solid #888;
        border-radius: 4px;
        background: #f0f0f0;
        color: #111;
        font-size: 14px;
        font-family: system-ui, sans-serif;
        cursor: pointer;
        white-space: nowrap;
    }
    .ggb-button:hover {
        background: #e0e0e0;
    }
    .hint {
        margin-top: 8px;
        font-size: 11px;
        color: #666;
        font-family: monospace;
    }
</style>
