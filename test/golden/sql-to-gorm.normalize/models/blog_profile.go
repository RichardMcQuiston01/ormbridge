package models

import "time"

// BlogProfile maps to the "blog_profiles" table.
type BlogProfile struct {
	ID        int32     `gorm:"primaryKey;autoIncrement"`
	Bio       *string   `gorm:"type:text"`
	Avatar    *string   `gorm:"size:100"`
	CreatedAt time.Time `gorm:"not null;autoCreateTime"`
	UpdatedAt time.Time `gorm:"not null;autoUpdateTime"`
	UserID    int32     `gorm:"not null;unique"`

	User BlogUser `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
}
