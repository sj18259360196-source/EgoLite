import { randomUUID } from "node:crypto";

import type { CollectionItem, CollectionFolder } from "@ego-compat/protocol";

export interface CollectionStore {
  loadCollections(): CollectionItem[];
  saveCollections(items: CollectionItem[]): void;
  loadCollectionFolders?(): CollectionFolder[] | undefined;
  saveCollectionLibrary?(items: CollectionItem[], folders: CollectionFolder[]): void;
}

export interface CollectionImportEntry {
  text: string;
  sourceUrl?: string;
  pageTitle?: string;
  faviconUrl?: string;
  group?: string;
  tags?: string[];
  createdAt?: string;
  kind?: "bookmark" | "excerpt";
  folderId?: string;
  order?: number;
}

export class CollectionService {
  readonly #store: CollectionStore | undefined;
  #items: CollectionItem[];
  #folders: CollectionFolder[];
  #committed: { items: CollectionItem[]; folders: CollectionFolder[] };

  constructor(store?: CollectionStore) {
    this.#store = store;
    this.#items = store?.loadCollections() ?? [];
    const folders = store?.loadCollectionFolders?.();
    this.#folders = folders ?? [
      { id: "bar", name: "收藏栏", parentId: null, order: 0 },
      { id: "other", name: "其他收藏", parentId: null, order: 1 },
    ];
    this.#committed = structuredClone({ items: this.#items, folders: this.#folders });
    if (!folders) {
      for (const [index, item] of this.#items.entries()) {
        let folder = this.#folders.find((entry) => entry.parentId === "other" && entry.name === item.group);
        if (item.group && !folder) {
          folder = { id: randomUUID(), name: item.group, parentId: "other", order: this.#folders.length };
          this.#folders.push(folder);
        }
        item.folderId ??= folder?.id ?? "other";
        item.order ??= index;
        if (!item.kind && item.sourceUrl && (item.text === item.pageTitle || item.text === item.sourceUrl)) item.kind = "bookmark";
      }
      if (store?.saveCollectionLibrary) this.#persist();
    }
  }

  save(text: string, metadata: Omit<CollectionItem, "id" | "text" | "createdAt"> = {}) {
    const normalized = text.trim();
    if (!normalized) return false;
    this.#items.unshift({
      id: randomUUID(),
      text: normalized,
      ...metadata,
      kind: metadata.kind ?? "excerpt",
      createdAt: new Date().toISOString(),
      folderId: metadata.folderId ?? this.#groupFolder(metadata.group),
      order: this.#items.length,
    });
    this.#persist();
    return true;
  }

  list(query?: string): CollectionItem[] {
    const needle = query?.trim().toLocaleLowerCase();
    const active = this.#items.filter((item) => !item.deletedAt);
    const items = needle
      ? active.filter((item) =>
          [item.text, item.sourceUrl, item.pageTitle, item.group, ...(item.tags ?? [])]
            .filter(Boolean)
            .some((value) => value!.toLocaleLowerCase().includes(needle)),
        )
      : active;
    return structuredClone(items);
  }

  update(id: string, changes: { group?: string | null; text?: string; pageTitle?: string | null; tags?: string[] }): CollectionItem | false {
    const index = this.#items.findIndex((item) => item.id === id && !item.deletedAt);
    if (index < 0) return false;
    const current = this.#items[index];
    if (!current) return false;
    const updated: CollectionItem = { ...current };
    if (Object.prototype.hasOwnProperty.call(changes, "group")) {
      const group = changes.group?.trim().slice(0, 120) || undefined;
      if (group) updated.group = group;
      else delete updated.group;
      updated.folderId = this.#groupFolder(group);
    }
    if (Object.prototype.hasOwnProperty.call(changes, "text")) {
      const text = changes.text?.trim().slice(0, 20_000);
      if (!text) return false;
      updated.text = text;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "pageTitle")) {
      const pageTitle = changes.pageTitle?.trim().slice(0, 2_000) || undefined;
      if (pageTitle) updated.pageTitle = pageTitle;
      else delete updated.pageTitle;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "tags")) {
      const tags = normalizeTags(changes.tags);
      if (tags.length) updated.tags = tags;
      else delete updated.tags;
    }
    this.#items[index] = updated;
    this.#persist();
    return structuredClone(updated);
  }

  move(ids: string[], group?: string | null): { updated: CollectionItem[]; missing: string[] } {
    const requested = [...new Set(ids.filter(Boolean))];
    const requestedSet = new Set(requested);
    const normalizedGroup = group?.trim().slice(0, 120) || undefined;
    const updated: CollectionItem[] = [];
    for (const [index, current] of this.#items.entries()) {
      if (!requestedSet.has(current.id)) continue;
      if (current.deletedAt) continue;
      const next: CollectionItem = normalizedGroup ? { ...current, group: normalizedGroup } : { ...current };
      if (!normalizedGroup) delete next.group;
      next.folderId = this.#groupFolder(normalizedGroup);
      this.#items[index] = next;
      updated.push(structuredClone(next));
      requestedSet.delete(current.id);
    }
    if (updated.length) this.#persist();
    return { updated, missing: requested.filter((id) => requestedSet.has(id)) };
  }

  delete(id: string): boolean {
    return this.remove([id]).removed.length > 0;
  }

  remove(ids: string[]): { removed: string[]; missing: string[] } {
    const requested = [...new Set(ids.filter(Boolean))];
    const existing = new Set(this.list().map((item) => item.id));
    const removed = requested.filter((id) => existing.has(id));
    if (removed.length) {
      const removedSet = new Set(removed);
      const deletedAt = new Date().toISOString();
      const deletionBatch = randomUUID();
      this.#items = this.#items.map((item) => removedSet.has(item.id) ? { ...item, deletedAt, deletionBatch } : item);
      this.#persist();
    }
    return { removed, missing: requested.filter((id) => !existing.has(id)) };
  }

  merge(ids: string[], primaryId?: string): { merged: CollectionItem | false; removed: string[]; missing: string[] } {
    const requested = [...new Set(ids.filter(Boolean))];
    const matches = requested.map((id) => this.#items.find((item) => item.id === id && !item.deletedAt)).filter((item): item is CollectionItem => Boolean(item));
    if (matches.length < 2) return { merged: false, removed: [], missing: requested.filter((id) => !matches.some((item) => item.id === id)) };
    const primary = matches.find((item) => item.id === primaryId) ?? matches[0]!;
    const texts = [...new Set(matches.map((item) => item.text.trim()).filter(Boolean))];
    const merged: CollectionItem = {
      ...primary,
      text: texts.join("\n\n"),
      tags: normalizeTags(matches.flatMap((item) => item.tags ?? [])),
      createdAt: matches.map((item) => item.createdAt).sort()[0] ?? primary.createdAt,
    };
    for (const key of ["sourceUrl", "pageTitle", "faviconUrl", "group"] as const) {
      const value = primary[key] || matches.find((item) => item[key])?.[key];
      if (value) merged[key] = value;
    }
    if (!merged.tags?.length) delete merged.tags;
    const removed = matches.filter((item) => item.id !== primary.id).map((item) => item.id);
    const removedSet = new Set(removed);
    this.#items = this.#items.filter((item) => !removedSet.has(item.id)).map((item) => item.id === primary.id ? merged : item);
    this.#persist();
    return { merged: structuredClone(merged), removed, missing: requested.filter((id) => !matches.some((item) => item.id === id)) };
  }

  import(entries: CollectionImportEntry[]): { added: number; skipped: number } {
    const existing = new Set(this.list().map(collectionKey));
    let added = 0;
    let skipped = 0;
    const imported: CollectionItem[] = [];
    for (const entry of entries.slice(0, 10_000)) {
      const text = entry.text.trim();
      if (!text) {
        skipped += 1;
        continue;
      }
      const item: CollectionItem = {
        id: randomUUID(),
        text,
        ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
        ...(entry.pageTitle ? { pageTitle: entry.pageTitle } : {}),
        ...(entry.faviconUrl ? { faviconUrl: entry.faviconUrl } : {}),
        ...(entry.group?.trim() ? { group: entry.group.trim().slice(0, 120) } : {}),
        ...(normalizeTags(entry.tags).length ? { tags: normalizeTags(entry.tags) } : {}),
        createdAt: validDate(entry.createdAt) ?? new Date().toISOString(),
        folderId: entry.folderId && this.#folders.some((folder) => folder.id === entry.folderId && !folder.deletedAt) ? entry.folderId : this.#groupFolder(entry.group),
        order: typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : this.#items.length + imported.length,
        ...(entry.kind ? { kind: entry.kind } : entry.sourceUrl && entry.text === entry.pageTitle ? { kind: "bookmark" as const } : {}),
      };
      const key = collectionKey(item);
      if (existing.has(key)) {
        skipped += 1;
        continue;
      }
      existing.add(key);
      imported.push(item);
      added += 1;
    }
    if (imported.length) {
      this.#items = [...imported, ...this.#items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      this.#persist();
    }
    return { added, skipped };
  }

  #persist(): void {
    try {
      if (this.#store?.saveCollectionLibrary) this.#store.saveCollectionLibrary(this.#items, this.#folders);
      else this.#store?.saveCollections(this.#items);
      this.#committed = structuredClone({ items: this.#items, folders: this.#folders });
    } catch (error) {
      this.#items = structuredClone(this.#committed.items);
      this.#folders = structuredClone(this.#committed.folders);
      throw error;
    }
  }

  snapshot() {
    return structuredClone({ items: this.#items, folders: this.#folders });
  }

  importLibrary(entries: CollectionImportEntry[], folders: CollectionFolder[]) {
    if (folders.length > 10_000 || entries.length > 10_000) throw new Error("Import is too large");
    const staged = new CollectionService();
    staged.#items = structuredClone(this.#items);
    staged.#folders = structuredClone(this.#folders);
    const remap = new Map<string, string>([["bar", "bar"], ["other", "other"]]);
    const pending = folders.filter(folder => folder.id !== "bar" && folder.id !== "other" && !folder.deletedAt);
    if (new Set(pending.map(folder => folder.id)).size !== pending.length) throw new Error("Duplicate folder IDs");
    while (pending.length) {
      let progress = false;
      for (let index = pending.length - 1; index >= 0; index--) {
        const folder = pending[index]!;
        const parent = remap.get(folder.parentId ?? "other");
        if (!parent) continue;
        const existing = staged.#folders.find(entry => !entry.deletedAt && entry.parentId === parent && entry.name === folder.name);
        const target = existing ?? staged.folderSave(folder.name, parent);
        remap.set(folder.id, target.id);
        if (!existing) staged.#folder(target.id).order = folder.order;
        pending.splice(index, 1);
        progress = true;
      }
      if (!progress) throw new Error("Invalid or cyclic folder tree");
    }
    const mapped = entries.map(entry => {
      if (entry.folderId && !remap.has(entry.folderId)) throw new Error("Missing imported folder");
      return { ...entry, ...(entry.folderId ? { folderId: remap.get(entry.folderId)! } : {}) };
    });
    const result = staged.import(mapped);
    this.#items = staged.#items;
    this.#folders = staged.#folders;
    this.#syncGroups();
    this.#persist();
    return result;
  }

  #folder(id: string) {
    const folder = this.#folders.find((entry) => entry.id === id && !entry.deletedAt);
    if (!folder) throw new Error("Folder not found");
    return folder;
  }

  #groupFolder(group?: string) {
    if (!group) return "other";
    let folder = this.#folders.find((entry) => !entry.deletedAt && entry.name === group && entry.parentId === "other");
    if (!folder) {
      folder = { id: randomUUID(), name: group, parentId: "other", order: this.#folders.length };
      this.#folders.push(folder);
    }
    return folder.id;
  }

  folderSave(name: string, parentId = "other", id?: string) {
    name = name.trim().slice(0, 120);
    if (!name) throw new Error("Folder name is required");
    this.#folder(parentId);
    if (id === "bar" || id === "other") throw new Error("Root folders cannot be changed");
    let ancestor: string | null = parentId;
    while (ancestor) {
      if (ancestor === id) throw new Error("A folder cannot contain itself");
      ancestor = this.#folder(ancestor).parentId;
    }
    const folder = id ? this.#folder(id) : { id: randomUUID(), name, parentId, order: this.#nextOrder(parentId) };
    if (this.#folders.some((entry) => !entry.deletedAt && entry.id !== folder.id && entry.parentId === parentId && entry.name === name)) throw new Error("A folder with this name already exists");
    folder.name = name;
    if (folder.parentId !== parentId) folder.order = this.#nextOrder(parentId);
    folder.parentId = parentId;
    if (!id) this.#folders.push(folder);
    this.#syncGroups();
    this.#persist();
    return structuredClone(folder);
  }

  #nextOrder(folderId: string) {
    return Math.max(-1, ...this.#items.filter((item) => item.folderId === folderId).map((item) => item.order ?? 0),
      ...this.#folders.filter((folder) => folder.parentId === folderId).map((folder) => folder.order)) + 1;
  }

  #syncGroups() {
    for (const item of this.#items) {
      const folder = this.#folders.find((entry) => entry.id === item.folderId);
      if (folder?.parentId) item.group = folder.name;
      else delete item.group;
    }
  }

  bookmark(input: { id?: string; title: string; url: string; folderId?: string; faviconUrl?: string; copy?: boolean; tags?: string[] }) {
    const parsed = new URL(input.url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) throw new Error("Unsupported bookmark URL");
    const url = parsed.href;
    const existing = input.id
      ? this.#items.find((item) => item.id === input.id && !item.deletedAt)
      : !input.copy ? this.#items.find((item) => !item.deletedAt && item.kind === "bookmark" && item.sourceUrl === url) : undefined;
    if (input.id && !existing) throw new Error("Bookmark not found");
    const folderId = input.folderId ?? existing?.folderId ?? "other";
    this.#folder(folderId);
    const title = input.title.trim().slice(0, 2000) || url;
    if (existing) {
      existing.pageTitle = title;
      existing.sourceUrl = url;
      existing.kind = "bookmark";
      if (existing.folderId !== folderId) existing.order = this.#nextOrder(folderId);
      existing.folderId = folderId;
      if (input.tags) existing.tags = normalizeTags(input.tags);
    } else {
      this.#items.unshift({
        id: randomUUID(), text: title, pageTitle: title, sourceUrl: url,
        kind: "bookmark", folderId, order: this.#nextOrder(folderId),
        ...(input.faviconUrl ? { faviconUrl: input.faviconUrl } : {}),
        ...(input.tags?.length ? { tags: normalizeTags(input.tags) } : {}),
        createdAt: new Date().toISOString(),
      });
    }
    this.#syncGroups();
    this.#persist();
    return structuredClone(existing ?? this.#items[0]!);
  }

  libraryMove(ids: string[], folderId: string, beforeId?: string) {
    this.#folder(folderId);
    const unique = [...new Set(ids)];
    const records = unique.map((id) => {
      const item = this.#items.find((entry) => entry.id === id && !entry.deletedAt);
      const folder = this.#folders.find((entry) => entry.id === id && !entry.deletedAt);
      if (!item && !folder) throw new Error("Collection not found");
      if (folder) {
        if (!folder.parentId) throw new Error("Root folders cannot be moved");
        let parent: string | null = folderId;
        while (parent) {
          if (parent === id) throw new Error("A folder cannot contain itself");
          parent = this.#folder(parent).parentId;
        }
      }
      return { item, folder };
    });
    const siblings = [
      ...this.#items.filter((item) => !item.deletedAt && item.folderId === folderId),
      ...this.#folders.filter((folder) => !folder.deletedAt && folder.parentId === folderId),
    ].filter((entry) => !unique.includes(entry.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const position = beforeId ? siblings.findIndex((entry) => entry.id === beforeId) : siblings.length;
    if (position < 0) throw new Error("Drop target no longer exists");
    for (const { item, folder } of records) {
      if (item) item.folderId = folderId;
      if (folder) folder.parentId = folderId;
    }
    siblings.splice(position, 0, ...records.map(({ item, folder }) => (item ?? folder)!));
    siblings.forEach((entry, index) => { entry.order = index; });
    this.#syncGroups();
    this.#persist();
    return true;
  }

  trash(ids: string[]) {
    if (ids.some((id) => id === "bar" || id === "other")) throw new Error("Root folders cannot be deleted");
    const selected = new Set(ids);
    let size;
    do {
      size = selected.size;
      for (const folder of this.#folders) if (folder.parentId && selected.has(folder.parentId)) selected.add(folder.id);
    } while (size !== selected.size);
    const deletedAt = new Date().toISOString();
    const deletionBatch = randomUUID();
    let count = 0;
    for (const entry of [...this.#folders, ...this.#items]) {
      if (entry.deletedAt) continue;
      if (selected.has(entry.id) || ("folderId" in entry && entry.folderId && selected.has(entry.folderId))) {
        entry.deletedAt = deletedAt;
        entry.deletionBatch = deletionBatch;
        count++;
      }
    }
    this.#persist();
    return count;
  }

  restore(ids: string[]) {
    const selected = new Set(ids);
    const batches = new Set(this.#folders.filter((folder) => selected.has(folder.id) && folder.deletedAt).map((folder) => folder.deletionBatch));
    const entries = [...this.#folders, ...this.#items].filter((entry) =>
      entry.deletedAt && (selected.has(entry.id) || (entry.deletionBatch && batches.has(entry.deletionBatch))));
    for (const entry of entries) {
      delete entry.deletedAt;
      delete entry.deletionBatch;
    }
    for (const entry of entries) {
      if ("parentId" in entry && entry.parentId && !this.#folders.some((folder) => folder.id === entry.parentId && !folder.deletedAt)) entry.parentId = "other";
      if ("folderId" in entry && !this.#folders.some((folder) => folder.id === entry.folderId && !folder.deletedAt)) entry.folderId = "other";
    }
    this.#syncGroups();
    this.#persist();
    return entries.length;
  }
}

function normalizeTags(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim().slice(0, 60)).filter(Boolean))].slice(0, 30);
}

function collectionKey(item: Pick<CollectionItem, "text" | "sourceUrl" | "folderId">): string {
  return `${item.folderId ?? "other"}\n${item.sourceUrl?.trim() ?? ""}\n${item.text.trim()}`;
}

function validDate(value?: string): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
