package models

import "time"

// User maps to the "users" table.
type User struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`

	Posts       []Post   `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`
	EditedPosts []Post   `gorm:"foreignKey:EditorID;constraint:OnDelete:SET NULL"`
	Profile     *Profile `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}
