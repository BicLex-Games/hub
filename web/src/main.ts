const params = new URLSearchParams(location.search);

if (params.get("imagePreview") === "1") void import("./image-preview");
else void import("./app");
