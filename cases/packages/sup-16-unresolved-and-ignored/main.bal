import ballerina/scan;

public function main() {
    @scan:Suppress {rules: RULES, reason: "Constant rule list"}
    int listed = checkpanic int:fromString("1");
    @scan:Suppress {rules: [string `ballerina:1`], reason: "Template of constant text"}
    int unresolved = checkpanic int:fromString("2");
    _ = listed + unresolved;
}

const RULES = ["ballerina:1"];

function shorthand() {
    @scan:Suppress {rules, reason}
    int value = checkpanic int:fromString("3");
    _ = value;
}

const rules = ["ballerina:7"];
const reason = "Shorthand fields";

function escaped() {
    @scan:Suppress {rules: ["ballerina:\u{31}"], reason: "Escaped rule ID"}
    int value = checkpanic int:fromString("4");
    _ = value;
}

function commented() {
    @scan:Suppress {
        // SEC-1042
        rules: ["ballerina:1"],
        // Accepted until the parser is replaced
        reason: "Commented fields"
    }
    int value = checkpanic int:fromString("5");
    _ = value;
}

function workers() {
    @scan:Suppress {rules: ["ballerina:1"], reason: "Worker"}
    worker W {
        int value = checkpanic int:fromString("6");
        _ = value;
    }
}
