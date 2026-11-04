// Does not compile: a string is assigned to an int.
function brokenTestHelper() returns int {
    int value = "not a number";
    return value;
}
