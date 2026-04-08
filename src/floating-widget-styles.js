/**
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
 *
 * Floating widget styles as a JS string. The widget injects this via a
 * <style> element on mount; using a real .css import would require adding
 * a CSS loader to webpack.config.js, and the rest of the codebase has no
 * other CSS-in-JSX consumers, so we keep the dependency surface small.
 */

/* eslint-disable */
export const FLOATING_WIDGET_CSS = `

#webllm-widget-root {
	position: fixed;
	z-index: 99999;
	bottom: 0;
	right: 0;
	pointer-events: none;
}

#webllm-widget-root * {
	box-sizing: border-box;
}

/* ---- Floating icon (always visible) ---- */

.webllm-widget-icon {
	pointer-events: auto;
	position: fixed;
	bottom: 20px;
	right: 20px;
	width: 56px;
	height: 56px;
	border-radius: 50%;
	background: #1e1e1e;
	color: #fff;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	box-shadow: 0 4px 12px rgba( 0, 0, 0, 0.25 );
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 11px;
	font-weight: 600;
	user-select: none;
	transition: transform 0.15s ease, background 0.2s ease;
}

.webllm-widget-icon:hover {
	transform: scale( 1.05 );
}

.webllm-widget-icon[data-state="connecting"] { background: #888; }
.webllm-widget-icon[data-state="idle"]       { background: #555; }
.webllm-widget-icon[data-state="loading"]    { background: #f0a020; }
.webllm-widget-icon[data-state="ready"]      { background: #00a32a; }
.webllm-widget-icon[data-state="busy"]       { background: #2271b1; }
.webllm-widget-icon[data-state="error"]      { background: #d63638; }

.webllm-widget-icon-label {
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.webllm-widget-icon-stop {
	pointer-events: auto;
	position: fixed;
	bottom: 20px;
	right: 84px;
	height: 28px;
	padding: 0 10px;
	border-radius: 14px;
	background: #d63638;
	color: #fff;
	border: none;
	cursor: pointer;
	font-size: 11px;
	font-weight: 600;
}

/* ---- Modal ---- */

.webllm-widget-modal-backdrop {
	pointer-events: auto;
	position: fixed;
	inset: 0;
	background: rgba( 0, 0, 0, 0.5 );
	display: flex;
	align-items: center;
	justify-content: center;
}

.webllm-widget-modal {
	pointer-events: auto;
	background: #fff;
	color: #1e1e1e;
	border-radius: 8px;
	padding: 24px;
	max-width: 480px;
	width: 90%;
	box-shadow: 0 10px 30px rgba( 0, 0, 0, 0.3 );
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.webllm-widget-modal h2 {
	margin: 0 0 12px;
	font-size: 18px;
}

.webllm-widget-modal-meta {
	font-size: 13px;
	color: #555;
	margin: 8px 0;
}

.webllm-widget-modal-meta strong {
	color: #1e1e1e;
}

.webllm-widget-progress {
	width: 100%;
	height: 8px;
	background: #eee;
	border-radius: 4px;
	overflow: hidden;
	margin: 12px 0;
}

.webllm-widget-progress-bar {
	height: 100%;
	background: #2271b1;
	transition: width 0.2s ease;
}

.webllm-widget-progress-text {
	font-size: 12px;
	color: #555;
	margin-top: 4px;
}

.webllm-widget-error {
	background: #fcf0f1;
	border-left: 4px solid #d63638;
	padding: 8px 12px;
	margin: 12px 0;
	font-size: 13px;
	color: #8a1f21;
}

.webllm-widget-modal-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 16px;
}

.webllm-widget-button {
	padding: 8px 16px;
	border-radius: 4px;
	border: 1px solid transparent;
	cursor: pointer;
	font-size: 13px;
	font-weight: 500;
}

.webllm-widget-button-primary {
	background: #2271b1;
	color: #fff;
}

.webllm-widget-button-primary:disabled {
	background: #aaa;
	cursor: not-allowed;
}

.webllm-widget-button-secondary {
	background: #fff;
	color: #1e1e1e;
	border-color: #ccc;
}
`;
