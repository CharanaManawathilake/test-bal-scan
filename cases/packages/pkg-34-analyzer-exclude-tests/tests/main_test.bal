import ballerina/test;

@test:Config
function testProbe() {
    test:assertEquals(probe(), "probe");
}
