// North American area code → timezone, so a business is called in its own local hours even when the
// sheet has no timezone column. Split area codes use the zone most of the area is in.

const ZONES = {
  'America/New_York': `
    203 475 860 959 302 202 771 239 305 321 324 352 386 407 561 645 656 689 727 728 754 772 786 813 863 904 941 954
    229 404 470 478 678 706 762 770 912 943 502 606 859 207 227 240 301 410 443 667 339 351 413 508 617 774 781 857 978
    603 201 551 609 640 732 848 856 862 908 973 212 315 332 347 363 516 518 585 607 631 646 680 716 718 838 845 914 917
    929 934 252 336 472 704 743 828 910 919 980 984 216 220 234 283 326 330 380 419 436 440 513 567 614 740 937
    215 223 267 272 412 445 484 570 582 610 717 724 814 835 878 401 803 821 839 843 854 864 423 865 802
    276 434 540 571 686 703 757 804 826 948 304 681`,
  'America/Detroit': '231 248 269 313 517 586 616 679 734 810 906 947 989',
  'America/Indiana/Indianapolis': '260 317 463 574 765 812 930',
  'America/Chicago': `
    205 251 256 334 659 938 479 501 870 327 850 448 217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872
    219 319 515 563 641 712 316 620 785 913 270 364 225 318 337 504 985 218 320 507 612 651 763 952 228 601 662 769
    314 417 557 573 636 660 816 975 308 402 531 701 405 539 572 580 918 605 615 629 731 901 931
    210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979
    262 274 353 414 534 608 715 920`,
  'America/Denver': '303 719 720 970 983 406 505 575 385 435 801 307 915',
  'America/Boise': '208 986',
  'America/Phoenix': '480 520 602 623 928',
  'America/Los_Angeles': `
    209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805
    818 820 831 840 858 909 916 925 949 951 702 725 775 458 503 541 971 206 253 360 425 509 564`,
  'America/Anchorage': '907',
  'Pacific/Honolulu': '808',
  'America/Puerto_Rico': '787 939',
  'America/Toronto': `
    226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 753 807 905
    263 354 367 418 438 450 468 514 579 581 819 873`,
  'America/Winnipeg': '204 431 584',
  'America/Regina': '306 474 639',
  'America/Edmonton': '368 403 587 780 825',
  'America/Vancouver': '236 250 257 604 672 778',
  'America/Halifax': '782 902 428 506',
  'America/St_Johns': '709 879',
};

const BY_CODE = new Map();
for (const [tz, codes] of Object.entries(ZONES)) {
  for (const code of codes.trim().split(/\s+/)) BY_CODE.set(code, tz);
}

// '+15125550100' → 'America/Chicago'. Only for +1 numbers.
export function timezoneFromPhone(phone) {
  const m = /^\+1(\d{3})\d{7}$/.exec(String(phone ?? ''));
  return m ? BY_CODE.get(m[1]) ?? null : null;
}

// What people write in sheets ("EST", "Pacific", "central time") → an IANA timezone name.
const ALIASES = {
  eastern: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York',
  central: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', ct: 'America/Chicago',
  mountain: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mt: 'America/Denver',
  arizona: 'America/Phoenix',
  pacific: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles',
  alaska: 'America/Anchorage', akst: 'America/Anchorage', akdt: 'America/Anchorage',
  hawaii: 'Pacific/Honolulu', hst: 'Pacific/Honolulu',
  atlantic: 'America/Halifax', ast: 'America/Halifax', adt: 'America/Halifax',
};

export function timezoneAlias(text) {
  const key = String(text ?? '').toLowerCase().replace(/\b(standard|daylight|time|zone|us)\b/g, '').replace(/[^a-z]/g, '');
  return ALIASES[key] ?? null;
}
