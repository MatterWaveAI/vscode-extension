# Apply an answer's code

Under each code block of a finished answer there is **Apply**. MatterWave finds the file the block names (or asks which one), opens a diff of the file against the code, and changes nothing until you say Apply.

The change goes into the editor's buffer like any edit: **Undo** takes it back, and unsaved edits you had are kept. Every apply also takes a checkpoint; **MatterWave: Restore Checkpoint** puts a file back as it was.
