import { useEffect, useState, type FormEvent } from "react";
import { readError, redirectUnauthorized, send } from "./api";
import { announceDocumentsChanged } from "./ExpiryBanner";

export type DocumentItem = { id: number; name: string; expiresOn: string | null };
export type DocumentOwner = { kind: "vehicle" | "driver"; id: number };

/** Edit, remove and add the documents of a Vehículo or a Chofer: only a name and an optional expiry date, never a file. */
export function DocumentsPanel({ owner, initialDocuments = [] }: { owner: DocumentOwner; initialDocuments?: DocumentItem[] }) {
  const [documents, setDocuments] = useState<DocumentItem[]>(initialDocuments);
  const [message, setMessage] = useState("");
  const listPath = `/${owner.kind === "vehicle" ? "vehicles" : "drivers"}/${owner.id}/documents`;

  async function load() {
    try {
      const response = await send(listPath, "GET");
      if (await redirectUnauthorized(response)) return;
      if (!response.ok) setMessage("Unable to load documents");
      else setDocuments((await response.json() as { documents: DocumentItem[] }).documents);
    } catch {
      setMessage("Unable to reach the server");
    }
  }

  useEffect(() => { void load(); }, [listPath]);

  async function write(path: string, method: string, body: unknown, done: string) {
    try {
      const response = await send(path, method, body);
      if (await redirectUnauthorized(response)) return false;
      setMessage(response.ok ? done : await readError(response, "Unable to save the document"));
      if (response.ok) {
        announceDocumentsChanged();
        await load();
      }
      return response.ok;
    } catch {
      setMessage("Unable to reach the server");
      return false;
    }
  }

  // An empty date input means the document has no date yet.
  function fields(form: HTMLFormElement) {
    const values = new FormData(form);
    return { name: values.get("documentName"), expiresOn: values.get("expiresOn") || null };
  }

  function save(event: FormEvent<HTMLFormElement>, id: number) {
    event.preventDefault();
    void write(`/documents/${id}`, "PATCH", fields(event.currentTarget), "Document saved");
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    void write(listPath, "POST", fields(form), "Document added").then((ok) => { if (ok) form.reset(); });
  }

  return <section>
    <h2>Documents</h2>
    {message && <p role="status">{message}</p>}
    <ul>{documents.map((document) => <li key={`${document.id}-${document.name}-${document.expiresOn}`}>
      <form onSubmit={(event) => save(event, document.id)}>
        <label>Document<input name="documentName" maxLength={200} required defaultValue={document.name} /></label>
        <label>Expiry date<input type="date" name="expiresOn" defaultValue={document.expiresOn ?? ""} /></label>
        {document.expiresOn === null && <span> No date</span>}
        <button type="submit">Save document</button>
        <button type="button" onClick={() => void write(`/documents/${document.id}`, "DELETE", undefined, "Document removed")}>Remove document</button>
      </form>
    </li>)}</ul>
    <form onSubmit={add}>
      <h3>Add a document</h3>
      <label>Document<input name="documentName" maxLength={200} required /></label>
      <label>Expiry date<input type="date" name="expiresOn" /></label>
      <button type="submit">Add document</button>
    </form>
  </section>;
}
