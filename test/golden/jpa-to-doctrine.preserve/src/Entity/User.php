<?php

declare(strict_types=1);

namespace App\Entity;

use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

#[ORM\Entity]
#[ORM\Table(name: 'auth_user')]
class User
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'AUTO')]
    #[ORM\Column(name: 'id', type: 'integer')]
    private ?int $id = null;

    /** @var Collection<int, Post> */
    #[ORM\OneToMany(targetEntity: Post::class, mappedBy: 'author')]
    private Collection $posts;

    /** @var Collection<int, Post> */
    #[ORM\OneToMany(targetEntity: Post::class, mappedBy: 'editor')]
    private Collection $editedPosts;

    #[ORM\OneToOne(targetEntity: Profile::class, mappedBy: 'user')]
    private ?Profile $profile = null;

    public function __construct()
    {
        $this->posts = new ArrayCollection();
        $this->editedPosts = new ArrayCollection();
    }

    public function getId(): ?int
    {
        return $this->id;
    }

    /**
     * @return Collection<int, Post>
     */
    public function getPosts(): Collection
    {
        return $this->posts;
    }

    public function addPost(Post $post): static
    {
        if (!$this->posts->contains($post)) {
            $this->posts->add($post);
            $post->setAuthor($this);
        }

        return $this;
    }

    public function removePost(Post $post): static
    {
        if ($this->posts->removeElement($post)) {
            // The owning side is required, so it is not unset here.
        }

        return $this;
    }

    /**
     * @return Collection<int, Post>
     */
    public function getEditedPosts(): Collection
    {
        return $this->editedPosts;
    }

    public function addEditedPost(Post $editedPost): static
    {
        if (!$this->editedPosts->contains($editedPost)) {
            $this->editedPosts->add($editedPost);
            $editedPost->setEditor($this);
        }

        return $this;
    }

    public function removeEditedPost(Post $editedPost): static
    {
        if ($this->editedPosts->removeElement($editedPost)) {
            if ($editedPost->getEditor() === $this) {
                $editedPost->setEditor(null);
            }
        }

        return $this;
    }

    public function getProfile(): ?Profile
    {
        return $this->profile;
    }

    public function setProfile(?Profile $profile): static
    {
        $this->profile = $profile;
        if ($profile !== null) {
            $profile->setUser($this);
        }

        return $this;
    }
}
