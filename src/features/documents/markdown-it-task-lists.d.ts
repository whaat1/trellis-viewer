declare module 'markdown-it-task-lists' {
  import MarkdownIt from 'markdown-it';
  export default function taskLists(md: MarkdownIt, options?: { enabled?: boolean; label?: boolean; labelAfter?: boolean }): void;
}
