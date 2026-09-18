"""Validate the complete publication payload again at the server boundary."""
import math
import re
import unicodedata
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


def clean(text):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Section(StrictModel):
    heading: str = Field(min_length=2, max_length=60)
    content: str = Field(min_length=200, max_length=300)

    @model_validator(mode="after")
    def normalized(self):
        self.heading, self.content = clean(self.heading), clean(self.content)
        if not 2 <= len(self.heading) <= 60 or not 200 <= len(self.content) <= 300:
            raise ValueError("각 소제목의 내용은 200~300자여야 합니다.")
        return self


class Post(StrictModel):
    title: str = Field(min_length=5, max_length=100)
    sections: list[Section] = Field(min_length=2, max_length=50)

    def body(self):
        return "\n\n".join(f"{s.heading}\n{s.content}" for s in self.sections)


class StartJob(StrictModel):
    blogId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    speed: int = Field(ge=1, le=80)
    target: int = Field(ge=500, le=10000)
    keyword: str = Field(min_length=1, max_length=60)
    post: Post
    publish: bool = False

    @model_validator(mode="after")
    def validate_post(self):
        self.keyword, self.post.title = clean(self.keyword), clean(self.post.title)
        if not self.keyword or self.keyword.casefold() not in self.post.title.casefold():
            raise ValueError("제목에 핵심 키워드가 필요합니다.")
        if not 5 <= len(self.post.title) <= 100:
            raise ValueError("제목은 5~100자여야 합니다.")
        n = len(self.post.body().replace("\n", ""))
        if not math.ceil(self.target * .95) <= n <= math.floor(self.target * 1.05):
            raise ValueError("본문 분량이 목표 ±5%를 벗어났습니다.")
        return self


class Login(StrictModel):
    code: str = Field(min_length=1, max_length=256)


class Writer(StrictModel):
    blogId: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


class Input(StrictModel):
    kind: Literal["click", "text", "key", "scroll"]
    x: float = Field(default=0, ge=0, le=1100)
    y: float = Field(default=0, ge=0, le=760)
    text: str = Field(default="", max_length=4000)
    key: Literal["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] = "Enter"
    delta: int = Field(default=0, ge=-760, le=760)
