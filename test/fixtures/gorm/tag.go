package models

type Tag struct {
	ID    int32  `gorm:"primaryKey"`
	Label string `gorm:"size:50;not null"`
	Posts []Post `gorm:"many2many:blog_post_tags"`
}

func (Tag) TableName() string { return "blog_tag" }
