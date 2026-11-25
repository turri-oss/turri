# Check the interface reference against the code

Below is part of the software's interface reference as an agent took it from the code, each entry with where it is defined. The reference is given whole to every agent that regenerates or tests the code, and it is the one place its details are written: what it lacks or gets wrong, the regenerated software lacks or gets wrong. Every literal in it was checked to be in the code - so nothing in it is invented; what is left to check is that it is whole and right. Read each entry where it is defined, and follow the code to where each detail is worked out:

- **Its help, whole:** the text the program prints for it with `--help` - every paragraph, word for word. Where the code keeps a short help and a long one, the one `--help` prints.
- **Its choices:** every value it accepts, from wherever the code lists them - a constant elsewhere, the letters of a format. Choices worked out when it runs - filtered by what the machine has, taken from what is installed - go in its details, saying how, never as a fixed list that is not always the list.
- **Its default, what it takes, whether it repeats, is required or is hidden** - as the code has them; a default worked out when it runs, in its details, saying how.
- **Before you say what a set, a list or a mapping holds,** grep every line that builds it or adds to it - a set defined in one place is often added to in another, a mapping filtered further down - and read each. Correct an entry only where the code shows it wrong, and say the file and the line that show it.
- **What was missed:** grep the part for interface no entry holds - environment variables read through a constant or a helper, subcommands, arguments, routes a router adds - and add each.

Call `submit_capture_reference_checked` once, with every entry as the code has it - each that holds, word for word; each corrected; each missed - and every exclusion; and in `changes` what you changed, a line each, with why: the file and the line, and what its code does there. Never change one that holds.
