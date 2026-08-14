// 정사각 캔버스에서는 카피 길이에 따라 UI에 남는 세로 공간이 달라진다. 축척을 손으로
// 박아 두면 문구 한 줄만 늘어도 아래가 잘리므로, 렌더 시점에 남은 높이를 재서 정한다.
//
//   <div class="clip" data-fit="296x605" data-fit-max="1.5" data-fit-show="550">
//     <div class="fit-target"> …실제 크기의 UI… </div>
//   </div>
//
// data-fit      콘텐츠의 자연 크기 "너비x높이". UI는 항상 이 크기로 레이아웃된다.
// data-fit-max  최대 배율 (너무 키우면 흐려지고 촌스러워진다)
// data-fit-show 그중 실제로 보여 줄 높이(자연 단위). 나머지 꼬리는 잘라낸다.
;(function () {
  document.querySelectorAll("[data-fit]").forEach(function (clip) {
    var nat = clip.dataset.fit.split("x").map(Number)
    var w = nat[0]
    var h = nat[1]
    var show = Number(clip.dataset.fitShow || h)
    var max = Number(clip.dataset.fitMax || 2)

    var stage = clip.closest(".stage")
    var box = stage.getBoundingClientRect()
    var availH = box.height
    var availW = box.width

    // clip과 stage 사이에 낀 판(.panel)의 안쪽 여백은 UI가 못 쓰는 자리다.
    var node = clip.parentElement
    while (node && node !== stage) {
      var cs = getComputedStyle(node)
      availH -= parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      availW -= parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      node = node.parentElement
    }

    // 세로로 쌓는 장면은 높이가, 좌우로 나눈 장면은 폭이 먼저 걸린다.
    var s = Math.min(max, availH / show, availW / w)
    clip.style.width = w * s + "px"
    clip.style.height = show * s + "px"

    var target = clip.querySelector(".fit-target")
    target.style.width = w + "px"
    target.style.height = h + "px"
    target.style.transform = "scale(" + s + ")"
    target.style.transformOrigin = "top left"
  })
})()
