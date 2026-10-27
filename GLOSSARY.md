# turri

turri regenerates code, and the conformance tests that check it, from \*\*\*plain specs. This is the language its code, records, docs and rules share.

## Language

**Func-id**:
A functional spec's name in its module: lowercase letters, digits and hyphens, unique in the module, given by the author and not by position. A func-id renamed and nothing else - a pure rename - is renamed in the records and the tests' labels, nothing regenerated; renamed with any other change, it is one functional spec taken out and another added.
_Avoid_: frid, functionality number, functionality id

**Scenario-id**:
A test scenario's name under its functional spec, unique among that functional spec's scenarios.
_Avoid_: acceptance test number

**Test plain file**:
A `.plain` file holding the conformance and acceptance test scenarios of one functional spec, bound to it by module and func-id.
