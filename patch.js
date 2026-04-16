const fs = require('fs');
const contents = fs.readFileSync('debugged-areas.md', 'utf8');

const target = `| 169 | \`Canvas.jsx\` | Node deletion (Backspace/Delete) and multi-selection (Shift/Ctrl/Meta) via keyboard shortcuts were not disabled during navigation transitions (\`isAnimating\`). Fixing this prevents accidental deletion or selection state corruption if the user presses keys while diving into a nested canvas. Fixed by binding these React Flow key-code props to \`interactiveDisabled ? null : [...]\`. | ✅ Fixed (Session 26) |`;

const replacement = `| 169 | \`Canvas.jsx\` | Node deletion (Backspace/Delete) and multi-selection (Shift/Ctrl/Meta) via keyboard shortcuts were not disabled during navigation transitions (\`isAnimating\`). Fixing this prevents accidental deletion or selection state corruption if the user presses keys while diving into a nested canvas. Fixed by binding these React Flow key-code props to \`interactiveDisabled ? null : [...]\`. | ✅ Fixed (Session 26) |
| 170 | \`useCanvasActions.js\` | \`doClear\` could be triggered (e.g. from a persisting ConfirmDialog after pressing "Clear Canvas") while \`navigation.isAnimating\` is true. Clearing the nodes and calling \`resetStack\` mid-dive destructively corrupts the state transition. Fixed: Extracted \`isNavigationAnimatingRef\` down and guarded \`doClear\`. | ✅ Fixed (Session 27) |
| 171 | \`useCanvasActions.js\` | \`onConnect\` executes \`setEdges\` and \`takeSnapshot\`. If somehow fired during animation, it could snapshot an intermediate invalid state. Fixed: Added \`isAnimatingRef\` guard. | ✅ Fixed (Session 27) |
| 172 | \`useCanvasPersistence.js\` | \`saveCanvas\` could theoretically execute (via autosave debounce) mid-dive transition. Fixed: Added \`isAnimatingRef\` guard to abort save attempts while state is in flux. | ✅ Fixed (Session 27) |
| 173 | \`useCanvasPersistence.js\` | \`loadCanvas\` replaces all nodes and calls \`resetStack\`. If triggered by an IPC event during a dive transition, it would clash with the animation's own async state updates resulting in tree corruption. Fixed: Added \`isAnimatingRef\` early return guard. | ✅ Fixed (Session 27) |
| 174 | \`useCanvasPersistence.js\` | \`exportCanvasToPNG\` could be triggered mid-animation via IPC menu shortcuts, resulting in partial-transition graphical artifacts being exported to disk. Fixed: Added \`isAnimatingRef\` early return guard. | ✅ Fixed (Session 27) |`;

fs.writeFileSync('debugged-areas.md', contents.replace(target, replacement));
console.log('patched');
