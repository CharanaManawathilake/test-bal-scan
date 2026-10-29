import ballerina/scan;

function parseCount() returns int {
    @scan:Suppress {rules: ["ballerina:1"], reason: "A document whose name starts like the generated one"}
    int count = checkpanic int:fromString("1");
    return count;
}
