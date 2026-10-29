import ballerina/scan;

type Options record {|
    int retries = 1;
|};

type Pair [@scan:Suppress {rules: ["ballerina:1"], reason: "Tuple member"} int, string];

function connect(@scan:Suppress {rules: ["ballerina:1"], reason: "Included record parameter"} *Options options) {
}

public function main() {
    var parse = function () returns @scan:Suppress {rules: ["ballerina:1"], reason: "Anonymous function"} int {
        return 1;
    };
    @scan:Suppress {r\u{75}les: ["ballerina:1"], reason: "Escaped field name"}
    int value = checkpanic int:fromString("1");
    Pair pair = [value, "x"];
    connect();
    _ = parse() + pair[0];
}
