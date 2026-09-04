# Regenerate with:  vhs demo/demo.tape
#
# The GIF in the README is generated, not hand-recorded, so it can be redone
# when the output changes instead of quietly going stale. Everything runs
# against the stub backend in demo/backend.mjs inside a throwaway HOME — no
# vector store, no network, and none of the recorder's own paths or hostnames.
#
# Height is sized to the `doctor` block, which is the tallest thing shown.

Output docs/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1020
Set Height 520
Set Padding 20
Set TypingSpeed 45ms

# Off-camera: temp HOME, stub backend, a small repo, hooks installed. Setup is
# four commands in the README; filming `install` would spend a third of the
# recording on boilerplate.
Hide
Type "source demo/setup.sh && codeindex-sync claim $DEMO_REPO >/dev/null && codeindex-sync install >/dev/null && cd $DEMO_REPO && clear"
Enter
Sleep 5s
Show

# The point of the whole thing: commit, and it indexes itself.
Type "echo 'export const tokenize = (s) => s.split(/\s+/)' >> src/parser.js"
Sleep 400ms
Enter
Sleep 600ms

Type "git commit -am 'add tokenize'"
Sleep 400ms
Enter
Sleep 2.5s

Type "# the post-commit hook queued it; a detached drain is already indexing"
Enter
Sleep 1s

Type "codeindex-sync list"
Sleep 500ms
Enter
Sleep 3.5s

Type "clear"
Enter
Sleep 300ms

# And when you want to know the whole thing is wired up correctly.
Type "codeindex-sync doctor"
Sleep 500ms
Enter
Sleep 5s
