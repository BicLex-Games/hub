/// <reference types="vite/client" />
import "./style.css";

const params = new URLSearchParams(location.search);
const title = params.get("title") ?? "Image preview";
const src = params.get("src") ?? "";
const app = document.querySelector<HTMLDivElement>("#app")!;

document.documentElement.classList.add("image-preview-window");
document.title = title;
app.innerHTML = `<div class="standalone-image"><img alt="" /></div>`;

const image = app.querySelector("img") as HTMLImageElement;
image.alt = title;
image.src = src;
