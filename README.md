zsync
=====

TODO

Known issues
============

* Server may send whole file on range request when files are small and multiple ranges are specified. zsync currently
  does not handle this and throws exception because HTTP 200 instead of 206 received.
