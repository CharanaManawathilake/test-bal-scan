import ballerina/test;

@test:Config
function testParse() {
    int value = checkpanic int:fromString("5");
    test:assertEquals(value, 5);
}
