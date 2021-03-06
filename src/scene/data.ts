import { ExcalidrawElement } from "../element/types";

import { getDefaultAppState } from "../appState";

import { AppState } from "../types";
import { ExportType, PreviousScene } from "./types";
import { exportToCanvas, exportToSvg } from "./export";
import nanoid from "nanoid";
import { fileOpen, fileSave } from "browser-nativefs";
import { getCommonBounds } from "../element";

import i18n from "../i18n";

const LOCAL_STORAGE_KEY = "excalidraw";
const LOCAL_STORAGE_SCENE_PREVIOUS_KEY = "excalidraw-previos-scenes";
const LOCAL_STORAGE_KEY_STATE = "excalidraw-state";
const BACKEND_POST = "https://json.excalidraw.com/api/v1/post/";
const BACKEND_GET = "https://json.excalidraw.com/api/v1/";

// TODO: Defined globally, since file handles aren't yet serializable.
// Once `FileSystemFileHandle` can be serialized, make this
// part of `AppState`.
(window as any).handle = null;

interface DataState {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  selectedId?: number;
}

export function serializeAsJSON(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
): string {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 1,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
      },
      elements: elements.map(({ shape, isSelected, ...el }) => el),
    },
    null,
    2,
  );
}

function calculateScrollCenter(
  elements: readonly ExcalidrawElement[],
): { scrollX: number; scrollY: number } {
  let [x1, y1, x2, y2] = getCommonBounds(elements);

  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;

  return {
    scrollX: window.innerWidth / 2 - centerX,
    scrollY: window.innerHeight / 2 - centerY,
  };
}

export async function saveAsJSON(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) {
  const serialized = serializeAsJSON(elements, appState);

  const name = `${appState.name}.json`;
  await fileSave(
    new Blob([serialized], { type: "application/json" }),
    {
      fileName: name,
      description: "Excalidraw file",
    },
    (window as any).handle,
  );
}

export async function loadFromJSON() {
  const updateAppState = (contents: string) => {
    const defaultAppState = getDefaultAppState();
    let elements = [];
    let appState = defaultAppState;
    try {
      const data = JSON.parse(contents);
      elements = data.elements || [];
      appState = { ...defaultAppState, ...data.appState };
    } catch (e) {
      // Do nothing because elements array is already empty
    }
    return { elements, appState };
  };

  const blob = await fileOpen({
    description: "Excalidraw files",
    extensions: ["json"],
    mimeTypes: ["application/json"],
  });
  if (blob.handle) {
    (window as any).handle = blob.handle;
  }
  let contents;
  if ("text" in Blob) {
    contents = await blob.text();
  } else {
    contents = await (async () => {
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.readAsText(blob, "utf8");
        reader.onloadend = () => {
          if (reader.readyState === FileReader.DONE) {
            resolve(reader.result as string);
          }
        };
      });
    })();
  }
  const { elements, appState } = updateAppState(contents);
  return new Promise<DataState>(resolve => {
    resolve(
      restore(elements, { ...appState, ...calculateScrollCenter(elements) }),
    );
  });
}

export async function exportToBackend(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
) {
  let response;
  try {
    response = await fetch(BACKEND_POST, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeAsJSON(elements, appState),
    });
    const json = await response.json();
    if (json.id) {
      const url = new URL(window.location.href);
      url.searchParams.append("id", json.id);

      await navigator.clipboard.writeText(url.toString());
      window.alert(
        i18n.t("alerts.copiedToClipboard", {
          url: url.toString(),
          interpolation: { escapeValue: false },
        }),
      );
    } else {
      window.alert(i18n.t("alerts.couldNotCreateShareableLink"));
    }
  } catch (e) {
    window.alert(i18n.t("alerts.couldNotCreateShareableLink"));
    return;
  }
}

export async function importFromBackend(id: string | null) {
  let elements: readonly ExcalidrawElement[] = [];
  let appState: AppState = getDefaultAppState();
  const response = await fetch(`${BACKEND_GET}${id}.json`).then(data =>
    data.clone().json(),
  );
  if (response != null) {
    try {
      elements = response.elements || elements;
      appState = response.appState || appState;
    } catch (error) {
      window.alert(i18n.t("alerts.importBackendFailed"));
      console.error(error);
    }
  }
  return restore(elements, { ...appState, ...calculateScrollCenter(elements) });
}

export async function exportCanvas(
  type: ExportType,
  elements: readonly ExcalidrawElement[],
  canvas: HTMLCanvasElement,
  {
    exportBackground,
    exportPadding = 10,
    viewBackgroundColor,
    name,
    scale = 1,
  }: {
    exportBackground: boolean;
    exportPadding?: number;
    viewBackgroundColor: string;
    name: string;
    scale?: number;
  },
) {
  if (!elements.length)
    return window.alert(i18n.t("alerts.cannotExportEmptyCanvas"));
  // calculate smallest area to fit the contents in

  if (type === "svg") {
    const tempSvg = exportToSvg(elements, {
      exportBackground,
      viewBackgroundColor,
      exportPadding,
    });
    await fileSave(new Blob([tempSvg.outerHTML], { type: "image/svg+xml" }), {
      fileName: `${name}.svg`,
    });
    return;
  }

  const tempCanvas = exportToCanvas(elements, {
    exportBackground,
    viewBackgroundColor,
    exportPadding,
    scale,
  });
  tempCanvas.style.display = "none";
  document.body.appendChild(tempCanvas);

  if (type === "png") {
    const fileName = `${name}.png`;
    tempCanvas.toBlob(async (blob: any) => {
      if (blob) {
        await fileSave(blob, {
          fileName: fileName,
        });
      }
    });
  } else if (type === "clipboard") {
    const errorMsg = i18n.t("alerts.couldNotCopyToClipboard");
    try {
      tempCanvas.toBlob(async function(blob: any) {
        try {
          await navigator.clipboard.write([
            new window.ClipboardItem({ "image/png": blob }),
          ]);
        } catch (err) {
          window.alert(errorMsg);
        }
      });
    } catch (err) {
      window.alert(errorMsg);
    }
  } else if (type === "backend") {
    const appState = getDefaultAppState();
    if (exportBackground) {
      appState.viewBackgroundColor = viewBackgroundColor;
    }
    exportToBackend(elements, appState);
  }

  // clean up the DOM
  if (tempCanvas !== canvas) tempCanvas.remove();
}

function restore(
  savedElements: readonly ExcalidrawElement[],
  savedState: AppState,
): DataState {
  return {
    elements: savedElements.map(element => ({
      ...element,
      id: element.id || nanoid(),
      fillStyle: element.fillStyle || "hachure",
      strokeWidth: element.strokeWidth || 1,
      roughness: element.roughness || 1,
      opacity:
        element.opacity === null || element.opacity === undefined
          ? 100
          : element.opacity,
    })),
    appState: savedState,
  };
}

export function restoreFromLocalStorage() {
  const savedElements = localStorage.getItem(LOCAL_STORAGE_KEY);
  const savedState = localStorage.getItem(LOCAL_STORAGE_KEY_STATE);

  let elements = [];
  if (savedElements) {
    try {
      elements = JSON.parse(savedElements).map(
        ({ shape, ...element }: ExcalidrawElement) => element,
      );
    } catch (e) {
      // Do nothing because elements array is already empty
    }
  }

  let appState = null;
  if (savedState) {
    try {
      appState = JSON.parse(savedState);
    } catch (e) {
      // Do nothing because appState is already null
    }
  }

  return restore(elements, appState);
}

export function saveToLocalStorage(
  elements: readonly ExcalidrawElement[],
  state: AppState,
) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(elements));
  localStorage.setItem(LOCAL_STORAGE_KEY_STATE, JSON.stringify(state));
}

/**
 * Returns the list of ids in Local Storage
 * @returns array
 */
export function loadedScenes(): PreviousScene[] {
  const storedPreviousScenes = localStorage.getItem(
    LOCAL_STORAGE_SCENE_PREVIOUS_KEY,
  );
  if (storedPreviousScenes) {
    try {
      return JSON.parse(storedPreviousScenes);
    } catch (e) {
      console.error("Could not parse previously stored ids");
      return [];
    }
  }
  return [];
}

/**
 * Append id to the list of Previous Scenes in Local Storage if not there yet
 * @param id string
 */
export function addToLoadedScenes(id: string): void {
  const scenes = [...loadedScenes()];
  const newScene = scenes.every(scene => scene.id !== id);

  if (newScene) {
    scenes.push({
      timestamp: Date.now(),
      id,
    });
  }

  localStorage.setItem(
    LOCAL_STORAGE_SCENE_PREVIOUS_KEY,
    JSON.stringify(scenes),
  );
}
