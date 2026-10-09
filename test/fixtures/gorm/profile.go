package models

type Profile struct {
	ID     int32 `gorm:"primaryKey"`
	UserID int32 `gorm:"not null;uniqueIndex"`
	User   *User
	Bio    *string `gorm:"type:text"`
	Avatar *string `gorm:"size:100"`
}

func (Profile) TableName() string { return "blog_profile" }
