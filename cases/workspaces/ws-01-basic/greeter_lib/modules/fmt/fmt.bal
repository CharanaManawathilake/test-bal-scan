public function upper(string s) returns string {
    boolean b = true || s.length() > 0;
    return b ? s.toUpperAscii() : s;
}
