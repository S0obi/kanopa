export interface CopyString {
  file: string;
  line: number;
  text: string;
}
/** The words the interface shows people, from the source (JSX text, label-like props, toasts). */
export function strings(srcDir: string): CopyString[];
