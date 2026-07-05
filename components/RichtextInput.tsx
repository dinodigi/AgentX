"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";

/**
 * TipTap editor for richtext fields — replaces the bare textarea that was the
 * weakest handoff moment. Emits HTML through a hidden input so the existing
 * form/coercion path is untouched. StarterKit only: enough for body content,
 * no plugin sprawl.
 */
export function RichtextInput({ name, initialHtml }: { name: string; initialHtml: string }) {
  const [html, setHtml] = useState(initialHtml);
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    immediatelyRender: false, // SSR-safe under the App Router
    editorProps: {
      attributes: {
        class: "richtext-editor min-h-32 px-3 py-2 text-sm focus:outline-none",
      },
    },
    onUpdate: ({ editor }) => setHtml(editor.isEmpty ? "" : editor.getHTML()),
  });

  const btn = (active: boolean) =>
    `rounded p-1.5 transition-colors ${
      active
        ? "bg-[--color-brand-wash] text-brand-strong"
        : "text-[--color-ink-mute] hover:bg-[--color-paper] hover:text-[--color-ink]"
    }`;

  return (
    <div className="rounded-lg border border-[--color-line] bg-white focus-within:border-[--color-line-strong]">
      <input type="hidden" name={name} value={html} />
      {editor && (
        <div className="flex items-center gap-0.5 border-b border-[--color-line] px-1.5 py-1">
          <button
            type="button"
            title="Bold"
            onClick={() => editor.chain().focus().toggleBold().run()}
            className={btn(editor.isActive("bold"))}
          >
            <Bold className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Italic"
            onClick={() => editor.chain().focus().toggleItalic().run()}
            className={btn(editor.isActive("italic"))}
          >
            <Italic className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-[--color-line]" />
          <button
            type="button"
            title="Heading"
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            className={btn(editor.isActive("heading", { level: 2 }))}
          >
            <Heading2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Subheading"
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            className={btn(editor.isActive("heading", { level: 3 }))}
          >
            <Heading3 className="h-4 w-4" />
          </button>
          <span className="mx-1 h-4 w-px bg-[--color-line]" />
          <button
            type="button"
            title="Bullet list"
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            className={btn(editor.isActive("bulletList"))}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Numbered list"
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            className={btn(editor.isActive("orderedList"))}
          >
            <ListOrdered className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Quote"
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            className={btn(editor.isActive("blockquote"))}
          >
            <Quote className="h-4 w-4" />
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
