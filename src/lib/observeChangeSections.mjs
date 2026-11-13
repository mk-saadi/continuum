// All review sections share one observer. Drop element references and disconnect
// when the last section unmounts (including on refresh and tab closure).
const callbacks = new Map();
let observer;
export function observeChangeSection(element, callback) {
  if (!observer) observer = new IntersectionObserver(entries => {
    for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin:'300px' });
  callbacks.set(element, callback);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer?.unobserve(element);
    if (!callbacks.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}
