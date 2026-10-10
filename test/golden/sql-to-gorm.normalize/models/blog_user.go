package models

import "time"

// BlogUser maps to the "blog_users" table.
type BlogUser struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`

	AuthorBlogPosts []BlogPost   `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	EditorBlogPosts []BlogPost   `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	BlogProfile     *BlogProfile `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}
